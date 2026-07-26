use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
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

    use uuid::Uuid;

    use super::TransferScheduler;

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
}
