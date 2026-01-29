import type { JwtPayload } from 'jsonwebtoken';

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload & {
        id?: string;
        email?: string;
        plan?: string;
      };
      currentUser?: {
        id: string;
        email: string;
        username: string;
        display_name: string | null;
        bio: string | null;
        photo_link: string | null;
        plan: string;
        verified: boolean;
        created_at: string | Date;
        updated_at: string | Date;
      };
    }
  }
}

export {};
