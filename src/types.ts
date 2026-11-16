export interface Reader {
  id: string;
  name: string;
  description: string;
  interests: string[];
  isNew: boolean;
}

export interface Article {
  id: string;
  title: string;
  summary: string;
  category: string;
  subcategory?: string | null;
  publisher: string;
  publishedAt: string;
  body: string;
  art: string;
  imageUrl?: string | null;
  synthetic?: boolean;
}

export interface FeedItem {
  article: Article;
  rank: number;
  reason: string;
  impressionId?: string;
  isLiked?: boolean;
}

export interface Feed {
  generatedAt: string;
  strategy: string;
  items: FeedItem[];
}

export interface VisitorProfile {
  reader_id: string;
  expires_at: string;
}

export type FeedMode = 'normal' | 'loading' | 'empty' | 'error';
