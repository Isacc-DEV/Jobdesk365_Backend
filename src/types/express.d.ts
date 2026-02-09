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
        balance: number;
        verified: boolean;
        last_login_at: string | Date | null;
        last_login_place: string | null;
        roles: string[];
        created_at: string | Date;
        updated_at: string | Date;
      };
    }
  }
}

export {};
