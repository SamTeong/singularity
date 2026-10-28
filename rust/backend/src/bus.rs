//! Synchronous event bus behind the agent registry.
//!
//! Port of the `EventEmitter` `agents.mjs:40` exports and listens on
//! (`agents.mjs:208`, `:241`, `:280`, `:201`) plus the events `pty-ws.mjs`
//! fans out (`:63-98`). Deliberately **not** a `tokio::sync::broadcast`: a
//! broadcast channel drops frames for slow receivers (`RecvError::Lagged`),
//! and `crons.mjs:99` / `background.mjs:151` rely on every status/list event
//! arriving. Listeners are invoked synchronously, in subscription order, from
//! a snapshot of the listener list taken while holding the lock — a listener
//! is never called with the lock held, so it may subscribe, unsubscribe or
//! emit re-entrantly without deadlocking.

use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::agent_wire::{AgentWire, Status};

// VERIFY: bus-listener
/// A listener reference: cheap to clone, called for every emitted event.
pub type BusListener = Arc<dyn Fn(&BusEvent) + Send + Sync>;

// VERIFY: bus-event
/// Every frame the daemon pushes into the bus. `List` carries the whole
/// registry snapshot (`agents.mjs:201`); `Status`/`Output` are per agent
/// (`:208`, `:241`); the `Value` variants are the daemon-wide snapshots
/// `pty-ws.mjs:63-98` forwards verbatim.
#[derive(Clone, Debug, PartialEq)]
pub enum BusEvent {
    Output { id: String, data: String },
    Status { id: String, status: Status },
    List(Vec<AgentWire>),
    Usage(Value),
    Tasks(Value),
    Crons(Value),
    WindowAnchor(Value),
    History(Value),
    Background(Value),
}

// VERIFY: bus-subscribe
/// VERIFY: bus-unsubscribe
/// VERIFY: bus-emit
/// The bus handle. Cheap to clone (one `Arc`), so the registry, the HTTP/WS
/// layer and each subscriber can hold their own copy of the same bus.
#[derive(Clone, Default)]
pub struct Bus {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    next_id: Mutex<u64>,
    listeners: Mutex<Vec<(u64, BusListener)>>,
}

impl Bus {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers `listener` and returns the subscription id used by
    /// [`Bus::unsubscribe`].
    pub fn subscribe(&self, listener: BusListener) -> u64 {
        let id = {
            let mut next_id = self.inner.next_id.lock().unwrap();
            *next_id += 1;
            *next_id
        };
        self.inner.listeners.lock().unwrap().push((id, listener));
        id
    }

    /// Removes the listener registered under `id`; unknown ids are ignored.
    pub fn unsubscribe(&self, id: u64) {
        self.inner
            .listeners
            .lock()
            .unwrap()
            .retain(|(listener_id, _)| *listener_id != id);
    }

    /// Delivers `event` to every listener registered at the time of the call.
    /// The listener list is cloned before dispatch: a listener that
    /// unsubscribes itself mid-emit still receives the current event, and the
    /// lock is released before any listener runs.
    pub fn emit(&self, event: &BusEvent) {
        let listeners = self.inner.listeners.lock().unwrap().clone();
        for (_, listener) in listeners {
            listener(event);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn output(data: &str) -> BusEvent {
        BusEvent::Output {
            id: "agent-1".to_owned(),
            data: data.to_owned(),
        }
    }

    #[test]
    fn listeners_are_called_in_subscription_order() {
        let bus = Bus::new();
        let order = Arc::new(Mutex::new(Vec::new()));
        for label in ["first", "second", "third"] {
            let order = order.clone();
            bus.subscribe(Arc::new(move |_| order.lock().unwrap().push(label)));
        }
        bus.emit(&output("hello"));
        assert_eq!(*order.lock().unwrap(), ["first", "second", "third"]);
    }

    #[test]
    fn unsubscribe_stops_delivery_to_that_listener_only() {
        let bus = Bus::new();
        let kept = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicUsize::new(0));
        let kept_counter = kept.clone();
        bus.subscribe(Arc::new(move |_| {
            kept_counter.fetch_add(1, Ordering::SeqCst);
        }));
        let dropped_counter = dropped.clone();
        let id = bus.subscribe(Arc::new(move |_| {
            dropped_counter.fetch_add(1, Ordering::SeqCst);
        }));
        bus.emit(&output("one"));
        bus.unsubscribe(id);
        bus.emit(&output("two"));
        assert_eq!(kept.load(Ordering::SeqCst), 2);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        bus.unsubscribe(id); // unknown/second unsubscribe is a no-op
    }

    #[test]
    fn a_listener_may_unsubscribe_itself_during_emit_without_deadlock() {
        let bus = Bus::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let handle: Arc<Mutex<Option<u64>>> = Arc::new(Mutex::new(None));
        let inner_bus = bus.clone();
        let counter = calls.clone();
        let slot = handle.clone();
        let id = bus.subscribe(Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            if let Some(id) = *slot.lock().unwrap() {
                inner_bus.unsubscribe(id);
            }
        }));
        *handle.lock().unwrap() = Some(id);
        bus.emit(&output("first"));
        // The current event still reaches the listener that just unsubscribed.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        bus.emit(&output("second"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_listener_may_emit_nested_events() {
        let bus = Bus::new();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let nested_bus = bus.clone();
        let nested_seen = seen.clone();
        bus.subscribe(Arc::new(move |event| {
            if let BusEvent::Output { data, .. } = event {
                nested_seen.lock().unwrap().push(data.clone());
                if data == "outer" {
                    nested_bus.emit(&output("inner"));
                }
            }
        }));
        bus.emit(&output("outer"));
        assert_eq!(*seen.lock().unwrap(), ["outer", "inner"]);
    }
}
