import mongoose, { Schema, Document } from 'mongoose';

export type UserTier = 'free' | 'pro' | 'enterprise';

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  tier: UserTier;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },
    passwordHash: {
      type: String,
      required: true,
      select: false
    },
    tier: {
      type: String,
      enum: ['free', 'pro', 'enterprise'],
      default: 'free'
    }
  },
  {
    timestamps: true
  }
);

export const User = mongoose.model<IUser>('User', UserSchema);
