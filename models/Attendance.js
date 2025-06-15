import mongoose from 'mongoose';

   const attendanceSchema = new mongoose.Schema({
     employee: {
       type: mongoose.Schema.Types.ObjectId,
       ref: 'Employee',
       required: true,
     },
     location: {
       type: mongoose.Schema.Types.ObjectId,
       ref: 'Location',
       required: true,
     },
     date: {
       type: Date,
       required: true,
     },
     status: {
       type: String,
       enum: ['present', 'absent', 'leave', 'half-day'],
       required: true,
     },
     markedBy: {
       type: mongoose.Schema.Types.ObjectId,
       ref: 'User',
     },
     editedBy: {
       type: mongoose.Schema.Types.ObjectId,
       ref: 'User',
     },
     isDeleted: {
       type: Boolean,
       default: false,
     },
     deletedAt: {
       type: Date,
     },
     deletedBy: {
       type: mongoose.Schema.Types.ObjectId,
       ref: 'User',
     },
   }, {
     timestamps: true,
   });

   // Add unique index to prevent duplicate attendance records
   attendanceSchema.index(
     { employee: 1, date: 1, location: 1, isDeleted: 1 },
     { unique: true }
   );

   export default mongoose.model('Attendance', attendanceSchema);