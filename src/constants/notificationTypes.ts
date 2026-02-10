export const NOTIFICATION_TYPES = {
  RESUME_TEMPLATE_ADDED: 'resume_template_added',
  PROFILE_CREATED: 'profile_created',
  ASSIGN_BIDDER_REQUEST: 'assign_bidder_request',
  REASSIGN_BIDDER_REQUEST: 'reassign_bidder_request',
  UNASSIGN_BIDDER_REQUEST: 'unassign_bidder_request',
  ASSIGN_BIDDER: 'assign_bidder',
  ASSIGN_CALLER_REQUEST: 'assign_caller_request',
  ASSIGN_CALLER_ACCEPTED: 'assign_caller_accepted',
  ASSIGN_CALLER_REJECTED: 'assign_caller_rejected',
  INTERVIEW_REMINDER_30M: 'interview_reminder_30m',
  INTERVIEW_REMINDER_5M: 'interview_reminder_5m',
  TALENT_ADDED: 'talent_added',
  SYSTEM: 'system'
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];
