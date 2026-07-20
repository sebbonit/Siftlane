mod commands;
mod secrets;
mod state;
mod storage;
mod transfers;

pub fn run() {
    state::run();
}
