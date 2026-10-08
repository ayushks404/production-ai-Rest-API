import mongoose from 'mongoose';
import { config } from '../config/env.js';
import { logger } from './logger.js';

export async function connectMongo(): Promise<void> {
  try {
    await mongoose.connect(config.MONGODB_URL, {
      serverSelectionTimeoutMS: 5000
    });
    logger.info('MongoDB connected successfully');
  } catch (err: any) {
    logger.error('Initial MongoDB connection error', { error: err.message });
  }
}

mongoose.connection.on('disconnected', () => {
  logger.warn('MongoDB disconnected');
});

mongoose.connection.on('reconnected', () => {
  logger.info('MongoDB reconnected');
});
