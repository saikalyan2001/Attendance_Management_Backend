import cron from 'node-cron';
import { processCarryForwardUpdates } from './controllers/admin/attendanceController';

// Run every day at 2 AM
cron.schedule('0 2 * * *', () => {
  processCarryForwardUpdates();
});
