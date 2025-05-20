import type { Timestamp } from 'firebase-admin/firestore';

export type JobType = 'exportData' | 'deleteAccount' | 'anotherJobType' | 'anotherJobType2';

export type Job = {
  userId: string;
  userEmail: string;
  jobType: JobType;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  priority: number;
  createdAt: Timestamp;
  completedAt: Timestamp | null;
  errors: string[];
  attempts: number;
};
