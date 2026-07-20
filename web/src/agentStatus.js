// agent lifecycle -> the theme's fixed StatusPill kinds (done|active|review|error).
// Was triplicated across App.jsx/TasksBoard.jsx/CronJobs.jsx — a new lifecycle
// state had to be added in all 3 or a pill silently fell back to 'review'.
export const KIND = { starting: 'active', running: 'active', idle: 'review', detached: 'review', exited: 'error' };
