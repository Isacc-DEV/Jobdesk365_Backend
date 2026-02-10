import { createInterviewReminderNotifications } from './notifications.js';

let notificationInterval: NodeJS.Timeout | null = null;
let tickInFlight = false;

const runTick = async () => {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await createInterviewReminderNotifications(30);
    await createInterviewReminderNotifications(5);
  } catch (err) {
    console.error('[notifications] scheduler tick failed', err);
  } finally {
    tickInFlight = false;
  }
};

export const startNotificationScheduler = () => {
  if (notificationInterval) return;
  setTimeout(() => {
    void runTick();
  }, 5000);
  notificationInterval = setInterval(() => {
    void runTick();
  }, 60_000);
};
