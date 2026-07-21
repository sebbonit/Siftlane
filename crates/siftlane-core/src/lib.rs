//! Protocol-neutral domain model and transfer orchestration for Siftlane.

mod error;
mod model;
mod remote;
mod transfer;

pub use error::{AppError, ErrorCode};
pub use model::*;
pub use remote::{RemoteCapabilities, RemoteFilesystem};
pub use transfer::{TransferListFilter, TransferQueue};
