mod commands;
mod package;
mod search;
mod secrets;
mod state;
mod storage;
mod transfer_plan;
mod transfers;

pub fn run() {
    state::run();
}
