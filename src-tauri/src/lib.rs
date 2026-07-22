mod commands;
mod package;
mod secrets;
mod state;
mod storage;
mod transfers;

pub fn run() {
    state::run();
}
