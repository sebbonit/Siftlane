mod commands;
mod configuration;
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
