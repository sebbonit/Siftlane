mod commands;
mod configuration;
mod diagnostics;
mod external_edit;
mod package;
mod scheduler;
mod search;
mod secrets;
mod state;
mod storage;
mod transfer_plan;
mod transfers;

pub fn run() {
    state::run();
}
