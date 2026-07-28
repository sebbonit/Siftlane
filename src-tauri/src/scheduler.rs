use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::sync::Notify;
use uuid::Uuid;

#[derive(Debug)]
struct Limits {
    global: usize,
    per_endpoint: usize,
}

#[derive(Debug)]
struct SchedulerState {
    limits: Limits,
    active_global: usize,
    active_by_endpoint: HashMap<String, usize>,
    waiting: VecDeque<(Uuid, String)>,
}

#[derive(Debug)]
pub struct TransferScheduler {
    state: Mutex<SchedulerState>,
    changed: Notify,
}

#[derive(Debug, Default)]
pub struct BandwidthLimiter {
    buckets: Mutex<HashMap<String, BandwidthBucket>>,
}

#[derive(Debug)]
struct BandwidthBucket {
    tokens: f64,
    updated: Instant,
    limit: u64,
}

struct PendingBandwidthReservation<'a> {
    limiter: &'a BandwidthLimiter,
    reserved: Vec<(String, u64)>,
    bytes: usize,
    committed: bool,
}

impl Drop for PendingBandwidthReservation<'_> {
    fn drop(&mut self) {
        if self.committed || self.reserved.is_empty() {
            return;
        }
        let mut buckets = self
            .limiter
            .buckets
            .lock()
            .expect("bandwidth limiter lock poisoned");
        let now = Instant::now();
        for (key, limit) in &self.reserved {
            let Some(bucket) = buckets.get_mut(key) else {
                continue;
            };
            bucket.tokens = (bucket.tokens
                + now.duration_since(bucket.updated).as_secs_f64() * *limit as f64)
                .min(*limit as f64);
            bucket.updated = now;
            bucket.tokens = (bucket.tokens + self.bytes as f64).min(*limit as f64);
        }
    }
}

impl BandwidthLimiter {
    pub async fn acquire(
        &self,
        direction: &str,
        profile_id: Uuid,
        bytes: usize,
        global_limit: Option<u64>,
        profile_limit: Option<u64>,
    ) {
        let (wait, reserved) = {
            let mut buckets = self
                .buckets
                .lock()
                .expect("bandwidth limiter lock poisoned");
            let mut reserved = Vec::with_capacity(2);
            let wait = [
                (format!("global:{direction}"), global_limit),
                (format!("profile:{profile_id}:{direction}"), profile_limit),
            ]
            .into_iter()
            .filter_map(|(key, limit)| {
                let limit = limit.filter(|value| *value > 0)?;
                let bucket = buckets
                    .entry(key.clone())
                    .or_insert_with(|| BandwidthBucket {
                        tokens: limit as f64,
                        updated: Instant::now(),
                        limit,
                    });
                if bucket.limit != limit {
                    bucket.limit = limit;
                    bucket.tokens = bucket.tokens.min(limit as f64);
                }
                let now = Instant::now();
                bucket.tokens = (bucket.tokens
                    + now.duration_since(bucket.updated).as_secs_f64() * limit as f64)
                    .min(limit as f64);
                bucket.updated = now;
                bucket.tokens -= bytes as f64;
                reserved.push((key, limit));
                Some(if bucket.tokens < 0.0 {
                    Duration::from_secs_f64(-bucket.tokens / limit as f64)
                } else {
                    Duration::ZERO
                })
            })
            .max()
            .unwrap_or_default();
            (wait, reserved)
        };
        let mut reservation = PendingBandwidthReservation {
            limiter: self,
            reserved,
            bytes,
            committed: false,
        };
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        reservation.committed = true;
    }
}

impl TransferScheduler {
    pub fn new(global: u8, per_endpoint: u8) -> Self {
        Self {
            state: Mutex::new(SchedulerState {
                limits: Limits {
                    global: global.max(1) as usize,
                    per_endpoint: per_endpoint.max(1) as usize,
                },
                active_global: 0,
                active_by_endpoint: HashMap::new(),
                waiting: VecDeque::new(),
            }),
            changed: Notify::new(),
        }
    }

    pub fn update_limits(&self, global: u8, per_endpoint: u8) {
        let mut state = self.state.lock().expect("transfer scheduler lock poisoned");
        state.limits = Limits {
            global: global.max(1) as usize,
            per_endpoint: per_endpoint.max(1) as usize,
        };
        drop(state);
        self.changed.notify_waiters();
    }

    pub fn set_waiting_order(&self, ordered_ids: &[Uuid]) {
        let mut state = self.state.lock().expect("transfer scheduler lock poisoned");
        let rank: HashMap<_, _> = ordered_ids
            .iter()
            .enumerate()
            .map(|(index, id)| (*id, index))
            .collect();
        state
            .waiting
            .make_contiguous()
            .sort_by_key(|(id, _)| rank.get(id).copied().unwrap_or(usize::MAX));
        drop(state);
        self.changed.notify_waiters();
    }

    pub async fn acquire(self: &Arc<Self>, transfer_id: Uuid, endpoint: String) -> TransferPermit {
        {
            let mut state = self.state.lock().expect("transfer scheduler lock poisoned");
            if !state.waiting.iter().any(|(id, _)| *id == transfer_id) {
                state.waiting.push_back((transfer_id, endpoint.clone()));
            }
        }

        loop {
            let notified = self.changed.notified();
            let acquired = {
                let mut state = self.state.lock().expect("transfer scheduler lock poisoned");
                let first_runnable = state.waiting.iter().position(|(_, candidate_endpoint)| {
                    state.active_global < state.limits.global
                        && state
                            .active_by_endpoint
                            .get(candidate_endpoint)
                            .copied()
                            .unwrap_or(0)
                            < state.limits.per_endpoint
                });
                if first_runnable
                    .and_then(|index| state.waiting.get(index))
                    .is_some_and(|(id, _)| *id == transfer_id)
                {
                    let index = first_runnable.expect("runnable waiter exists");
                    state.waiting.remove(index);
                    state.active_global += 1;
                    *state
                        .active_by_endpoint
                        .entry(endpoint.clone())
                        .or_default() += 1;
                    true
                } else {
                    false
                }
            };
            if acquired {
                return TransferPermit {
                    scheduler: self.clone(),
                    endpoint,
                };
            }
            notified.await;
        }
    }

    #[cfg(test)]
    fn active(&self) -> (usize, HashMap<String, usize>) {
        let state = self.state.lock().expect("transfer scheduler lock poisoned");
        (state.active_global, state.active_by_endpoint.clone())
    }
}

pub struct TransferPermit {
    scheduler: Arc<TransferScheduler>,
    endpoint: String,
}

impl Drop for TransferPermit {
    fn drop(&mut self) {
        let mut state = self
            .scheduler
            .state
            .lock()
            .expect("transfer scheduler lock poisoned");
        state.active_global = state.active_global.saturating_sub(1);
        if let Some(active) = state.active_by_endpoint.get_mut(&self.endpoint) {
            *active = active.saturating_sub(1);
            if *active == 0 {
                state.active_by_endpoint.remove(&self.endpoint);
            }
        }
        drop(state);
        self.scheduler.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use tokio::time::timeout;
    use uuid::Uuid;

    use super::{BandwidthLimiter, TransferScheduler};

    #[tokio::test]
    async fn enforces_global_and_per_endpoint_limits_and_updates_live() {
        let scheduler = Arc::new(TransferScheduler::new(2, 1));
        let first = scheduler.acquire(Uuid::new_v4(), "sftp://one".into()).await;
        let second = scheduler.acquire(Uuid::new_v4(), "sftp://two".into()).await;
        assert_eq!(scheduler.active().0, 2);

        scheduler.update_limits(3, 2);
        let third = scheduler.acquire(Uuid::new_v4(), "sftp://one".into()).await;
        assert_eq!(scheduler.active().0, 3);
        assert_eq!(scheduler.active().1["sftp://one"], 2);

        drop((first, second, third));
        assert_eq!(scheduler.active().0, 0);
    }

    #[tokio::test]
    async fn cancelled_bandwidth_wait_refunds_its_reservation() {
        let limiter = BandwidthLimiter::default();
        let profile_id = Uuid::new_v4();
        let cancelled = timeout(
            Duration::from_millis(10),
            limiter.acquire("upload", profile_id, 200, Some(100), None),
        )
        .await;
        assert!(cancelled.is_err());

        timeout(
            Duration::from_millis(50),
            limiter.acquire("upload", profile_id, 100, Some(100), None),
        )
        .await
        .expect("the cancelled reservation should be refunded");
    }
}
