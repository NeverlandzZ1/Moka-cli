export type Id = string | number;
export type JsonRecord = Record<string, unknown>;

export interface ApplicationRecord {
  applicationId: Id;
  candidateName: string;
  jobTitle: string;
  jobId?: Id;
}

export interface InterviewRecord extends ApplicationRecord {
  interviewId: Id;
  interviewerNames: string[];
  round?: number;
  roundName?: string;
  startTime?: number | string;
}

export interface MeetingSummaryRecord {
  transcriptStatus: 'available' | 'not_available';
  transcript?: unknown;
  transcriptType?: unknown;
  evaluationSummary?: unknown;
  questionAnalysis?: unknown;
  mokaCode?: number;
  mokaMessage?: string;
}

export interface TranscriptRecord extends InterviewRecord, MeetingSummaryRecord {}

export interface CollectionError {
  applicationId?: Id;
  interviewId?: Id;
  stage: 'interviewCard' | 'meetingSummary';
  message: string;
}

export interface CollectionResult {
  generatedAt: string;
  source: string;
  records: TranscriptRecord[];
  errors: CollectionError[];
  stats: {
    applications: number;
    interviews: number;
    transcriptsAvailable: number;
    transcriptsUnavailable: number;
    errors: number;
  };
}

