import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    ('MongoDB connected');
  } catch (error) {
    ('MongoDB connection error:', error);
    process.exit(1);
  }
};

export default connectDB;