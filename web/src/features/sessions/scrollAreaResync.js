const RESYNC_DELAY = 120;

export function createScrollAreaResync(resync, setTimer = setTimeout, clearTimer = clearTimeout) {
  let timer = null;

  return {
    schedule() {
      if (timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        resync();
      }, RESYNC_DELAY);
    },
    dispose() {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    },
  };
}
