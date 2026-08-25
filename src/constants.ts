export const MOKA_ORIGIN = 'https://app.mokahr.com';
export const MOKA_OVERVIEW_URL = `${MOKA_ORIGIN}/interviews/overview`;

export const API_PATHS = {
  interviewList: '/api/outer/ats-interview/interview/hr/interviewList',
  interviewCard: '/api/outer/ats-interview/interview/interviewCard',
  meetingSummary: '/api/outer/ats-interview/interview/meeting/getMeetingSummary',
} as const;

export const DEFAULT_CDP_PORT = 9222;
export const DEFAULT_LOGIN_WAIT_SECONDS = 15;

