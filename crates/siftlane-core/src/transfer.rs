use std::collections::HashMap;

use chrono::Utc;
use uuid::Uuid;

use crate::{AppError, ErrorCode, TransferId, TransferJob, TransferState};

#[derive(Debug, Default)]
pub struct TransferQueue {
    jobs: HashMap<TransferId, TransferJob>,
    order: Vec<TransferId>,
}

impl TransferQueue {
    pub fn restore(jobs: Vec<TransferJob>) -> Self {
        let mut queue = Self::default();
        for mut job in jobs {
            if job.state == TransferState::Running {
                job.state = TransferState::Interrupted;
            }
            queue.order.push(job.id);
            queue.jobs.insert(job.id, job);
        }
        queue
    }

    pub fn enqueue(&mut self, job: TransferJob) -> TransferId {
        let id = job.id;
        self.order.push(id);
        self.jobs.insert(id, job);
        id
    }

    pub fn list(&self) -> Vec<TransferJob> {
        self.order
            .iter()
            .filter_map(|id| self.jobs.get(id).cloned())
            .collect()
    }

    pub fn get(&self, id: TransferId) -> Option<&TransferJob> {
        self.jobs.get(&id)
    }

    pub fn update_conflict_policy(
        &mut self,
        id: TransferId,
        policy: crate::ConflictPolicy,
    ) -> Result<(), AppError> {
        let job = self.job_mut(id)?;
        job.conflict_policy = policy;
        job.updated_at = Utc::now();
        Ok(())
    }

    pub fn update_total(&mut self, id: TransferId, total: u64) -> Result<(), AppError> {
        let job = self.job_mut(id)?;
        job.bytes_total = Some(total);
        job.updated_at = Utc::now();
        Ok(())
    }

    pub fn set_error(&mut self, id: TransferId, message: Option<String>) -> Result<(), AppError> {
        let job = self.job_mut(id)?;
        job.error = message;
        job.updated_at = Utc::now();
        Ok(())
    }

    fn job_mut(&mut self, id: TransferId) -> Result<&mut TransferJob, AppError> {
        self.jobs.get_mut(&id).ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, format!("Transfer {id} was not found"))
        })
    }

    pub fn transition(&mut self, id: TransferId, next: TransferState) -> Result<(), AppError> {
        let job = self.jobs.get_mut(&id).ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, format!("Transfer {id} was not found"))
        })?;

        if !is_valid_transition(job.state, next) {
            return Err(AppError::new(
                ErrorCode::Conflict,
                format!("Cannot move transfer from {:?} to {next:?}", job.state),
            ));
        }

        job.state = next;
        job.updated_at = Utc::now();
        Ok(())
    }

    pub fn update_progress(
        &mut self,
        id: Uuid,
        bytes_transferred: u64,
        speed: Option<u64>,
    ) -> Result<(), AppError> {
        let job = self.jobs.get_mut(&id).ok_or_else(|| {
            AppError::new(ErrorCode::NotFound, format!("Transfer {id} was not found"))
        })?;
        if job.state != TransferState::Running {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "Progress can only be recorded for a running transfer",
            ));
        }
        if job
            .bytes_total
            .is_some_and(|total| bytes_transferred > total)
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "Transferred byte count exceeds the expected size",
            ));
        }
        job.bytes_transferred = bytes_transferred;
        job.speed_bytes_per_second = speed;
        job.updated_at = Utc::now();
        Ok(())
    }

    pub fn remove(&mut self, id: TransferId) -> Option<TransferJob> {
        self.order.retain(|item| *item != id);
        self.jobs.remove(&id)
    }

    pub fn clear_filter(&mut self, filter: TransferListFilter) -> Vec<TransferId> {
        let ids: Vec<_> = self
            .order
            .iter()
            .filter_map(|id| {
                self.jobs
                    .get(id)
                    .filter(|job| filter.matches(job.state))
                    .map(|job| job.id)
            })
            .collect();
        for id in &ids {
            if let Some(job) = self.jobs.get(id)
                && is_valid_transition(job.state, TransferState::Cancelled)
            {
                let _ = self.transition(*id, TransferState::Cancelled);
            }
            self.remove(*id);
        }
        ids
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferListFilter {
    All,
    Active,
    Completed,
    Failed,
}

impl TransferListFilter {
    pub fn matches(self, state: TransferState) -> bool {
        match self {
            Self::All => true,
            Self::Active => !state.is_terminal(),
            Self::Completed => state == TransferState::Completed,
            Self::Failed => matches!(state, TransferState::Failed | TransferState::Cancelled),
        }
    }
}

fn is_valid_transition(from: TransferState, to: TransferState) -> bool {
    use TransferState::*;
    matches!(
        (from, to),
        (Queued | Interrupted, Running)
            | (Queued | Running | Paused | Interrupted, Cancelled)
            | (
                Running,
                Paused
                    | WaitingForConflict
                    | WaitingForAuthentication
                    | Completed
                    | Failed
                    | Interrupted
            )
            | (
                Paused | WaitingForConflict | WaitingForAuthentication | Interrupted | Failed,
                Queued
            )
    )
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use crate::{TransferDirection, TransferJob, TransferState};

    use super::TransferQueue;

    #[test]
    fn running_jobs_are_interrupted_when_restored() {
        let mut job = TransferJob::new(
            Uuid::new_v4(),
            TransferDirection::Upload,
            "source".into(),
            "destination".into(),
            Some(100),
        );
        job.state = TransferState::Running;

        let queue = TransferQueue::restore(vec![job]);
        assert_eq!(queue.list()[0].state, TransferState::Interrupted);
    }

    #[test]
    fn completed_jobs_cannot_restart() {
        let mut queue = TransferQueue::default();
        let job = TransferJob::new(
            Uuid::new_v4(),
            TransferDirection::Download,
            "source".into(),
            "destination".into(),
            Some(100),
        );
        let id = queue.enqueue(job);
        queue.transition(id, TransferState::Running).unwrap();
        queue.transition(id, TransferState::Completed).unwrap();
        assert!(queue.transition(id, TransferState::Running).is_err());
    }

    #[test]
    fn interrupted_jobs_can_be_explicitly_requeued() {
        let mut queue = TransferQueue::default();
        let mut job = TransferJob::new(
            Uuid::new_v4(),
            TransferDirection::Download,
            "source".into(),
            "destination".into(),
            Some(100),
        );
        job.state = TransferState::Interrupted;
        let id = queue.enqueue(job);

        queue.transition(id, TransferState::Queued).unwrap();
        assert_eq!(queue.get(id).unwrap().state, TransferState::Queued);
    }

    #[test]
    fn clear_filter_removes_matching_jobs_only() {
        let mut queue = TransferQueue::default();
        let completed = {
            let job = TransferJob::new(
                Uuid::new_v4(),
                TransferDirection::Upload,
                "done".into(),
                "dest".into(),
                Some(10),
            );
            let id = queue.enqueue(job);
            queue.transition(id, TransferState::Running).unwrap();
            queue.transition(id, TransferState::Completed).unwrap();
            id
        };
        let failed = {
            let job = TransferJob::new(
                Uuid::new_v4(),
                TransferDirection::Upload,
                "bad".into(),
                "dest".into(),
                Some(10),
            );
            let id = queue.enqueue(job);
            queue.transition(id, TransferState::Running).unwrap();
            queue.transition(id, TransferState::Failed).unwrap();
            id
        };
        let active = queue.enqueue(TransferJob::new(
            Uuid::new_v4(),
            TransferDirection::Download,
            "active".into(),
            "dest".into(),
            Some(10),
        ));

        assert_eq!(
            queue.clear_filter(super::TransferListFilter::Completed),
            vec![completed]
        );
        assert!(queue.get(completed).is_none());
        assert!(queue.get(failed).is_some());
        assert!(queue.get(active).is_some());

        assert_eq!(
            queue.clear_filter(super::TransferListFilter::Failed),
            vec![failed]
        );
        assert_eq!(
            queue.clear_filter(super::TransferListFilter::Active),
            vec![active]
        );
        assert!(queue.list().is_empty());
    }

    #[test]
    fn clear_filter_all_removes_every_job() {
        let mut queue = TransferQueue::default();
        let first = queue.enqueue(TransferJob::new(
            Uuid::new_v4(),
            TransferDirection::Upload,
            "one".into(),
            "dest".into(),
            Some(10),
        ));
        let second = {
            let job = TransferJob::new(
                Uuid::new_v4(),
                TransferDirection::Download,
                "two".into(),
                "dest".into(),
                Some(10),
            );
            let id = queue.enqueue(job);
            queue.transition(id, TransferState::Running).unwrap();
            queue.transition(id, TransferState::Completed).unwrap();
            id
        };

        let removed = queue.clear_filter(super::TransferListFilter::All);
        assert_eq!(removed.len(), 2);
        assert!(removed.contains(&first));
        assert!(removed.contains(&second));
        assert!(queue.list().is_empty());
    }
}
