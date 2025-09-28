import mongoose from 'mongoose';

const jobStatusSchema = new mongoose.Schema({
  jobId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  status: { 
    type: String, 
    enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'],
    default: 'QUEUED'
  },
  progress: { type: Number, default: 0, min: 0, max: 100 },
  data: { type: Object },
  result: { type: Object },
  error: { type: String },
  createdAt: { type: Date, default: Date.now },
  startedAt: { type: Date },
  completedAt: { type: Date }
});

jobStatusSchema.index({ jobId: 1 });
jobStatusSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 }); // Auto-delete after 24h

export default mongoose.model('JobStatus', jobStatusSchema);
