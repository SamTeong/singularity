use serde::Serialize;
use std::collections::VecDeque;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use sysinfo::{MemoryRefreshKind, System};

const STEP: Duration = Duration::from_millis(2000);
const HISTORY_CAP: usize = 1800;

#[derive(Clone, Serialize)]
pub struct SysStats {
    cpu: Option<u8>,
    mem: Memory,
    history: History,
}

#[derive(Clone, Serialize)]
struct Memory {
    total: u64,
    used: u64,
    pct: u8,
}

#[derive(Clone, Serialize)]
struct History {
    cpu: Vec<Option<u8>>,
    mem: Vec<u8>,
    #[serde(rename = "stepMs")]
    step_ms: u64,
}

struct Sample {
    cpu: Option<u8>,
    mem: u8,
}

struct State {
    system: System,
    cpu: Option<u8>,
    history: VecDeque<Sample>,
}

impl State {
    fn start() -> Self {
        let mut system = System::new();
        system.refresh_cpu_usage();
        system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        Self {
            system,
            cpu: None,
            history: VecDeque::with_capacity(HISTORY_CAP),
        }
    }

    fn tick(&mut self) {
        self.system.refresh_cpu_usage();
        self.system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        self.record(
            self.system.global_cpu_usage(),
            self.system.total_memory(),
            self.system.free_memory(),
        );
    }

    fn record(&mut self, cpu_pct: f32, total: u64, free: u64) {
        let used = total.saturating_sub(free);
        if cpu_pct.is_finite() {
            self.cpu = Some(cpu_pct.clamp(0.0, 100.0).round() as u8);
        }
        let mem_pct = percent(used, total);
        self.history.push_back(Sample {
            cpu: self.cpu,
            mem: mem_pct,
        });
        if self.history.len() > HISTORY_CAP {
            self.history.pop_front();
        }
    }

    fn snapshot(&mut self) -> SysStats {
        self.system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        let total = self.system.total_memory();
        let used = total.saturating_sub(self.system.free_memory());
        SysStats {
            cpu: self.cpu,
            mem: Memory {
                total,
                used,
                pct: percent(used, total),
            },
            history: History {
                cpu: self.history.iter().map(|sample| sample.cpu).collect(),
                mem: self.history.iter().map(|sample| sample.mem).collect(),
                step_ms: STEP.as_millis() as u64,
            },
        }
    }
}

fn percent(used: u64, total: u64) -> u8 {
    if total == 0 {
        0
    } else {
        ((used as f64 * 100.0) / total as f64)
            .round()
            .clamp(0.0, 100.0) as u8
    }
}

pub struct Sampler {
    state: Arc<Mutex<State>>,
    stop: Option<Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

impl Sampler {
    pub fn start() -> Self {
        let state = Arc::new(Mutex::new(State::start()));
        let (stop, receiver) = mpsc::channel();
        let worker_state = Arc::clone(&state);
        let worker = thread::spawn(move || run(worker_state, receiver));
        Self {
            state,
            stop: Some(stop),
            worker: Some(worker),
        }
    }

    pub fn snapshot(&self) -> SysStats {
        self.state
            .lock()
            .expect("sysstats mutex poisoned")
            .snapshot()
    }

    pub fn stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for Sampler {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run(state: Arc<Mutex<State>>, stop: Receiver<()>) {
    loop {
        match stop.recv_timeout(STEP) {
            Err(RecvTimeoutError::Timeout) => state.lock().expect("sysstats mutex poisoned").tick(),
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_without_cpu_or_history_then_rounds_and_appends_aligned_samples() {
        let mut state = State::start();
        let initial = state.snapshot();
        assert_eq!(initial.cpu, None);
        assert!(initial.history.cpu.is_empty());
        assert!(initial.history.mem.is_empty());
        assert_eq!(initial.history.step_ms, 2000);

        state.record(27.5, 1000, 425);
        let sampled = state.snapshot();
        assert_eq!(sampled.cpu, Some(28));
        assert_eq!(sampled.history.cpu, [Some(28)]);
        assert_eq!(sampled.history.mem, [58]);
    }

    #[test]
    fn keeps_only_the_newest_aligned_history() {
        let mut state = State::start();
        for index in 0..=HISTORY_CAP {
            state.record(index as f32 % 100.0, index as u64, 0);
        }
        assert_eq!(state.history.len(), HISTORY_CAP);
        assert_eq!(state.history.front().unwrap().cpu, Some(1));
        assert_eq!(state.history.front().unwrap().mem, 100);
        assert_eq!(state.history.back().unwrap().cpu, Some(0));
    }

    #[test]
    fn windows_runtime_values_cadence_and_stop_are_bounded() {
        let mut sampler = Sampler::start();
        let initial = sampler.snapshot();
        assert!(initial.mem.total > 0);
        assert!(initial.mem.used <= initial.mem.total);
        assert_eq!(initial.cpu, None);
        assert!(initial.history.cpu.is_empty());
        thread::sleep(STEP + Duration::from_millis(150));
        let sampled = sampler.snapshot();
        assert!(sampled.cpu.is_some_and(|cpu| cpu <= 100));
        assert_eq!(sampled.history.cpu.len(), 1);
        assert_eq!(sampled.history.cpu.len(), sampled.history.mem.len());
        let started = std::time::Instant::now();
        sampler.stop();
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
