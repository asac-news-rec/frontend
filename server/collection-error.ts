// Stable, server-only diagnostic codes. Never derive these from raw error text.
export const collectionErrorCodes=[
 'SERVED_NOT_COMMITTED','READER_PROOF_INVALID','FEED_READER_MISMATCH',
 'LOGGING_IDENTITY_UNAVAILABLE','LOGGING_UNAVAILABLE'
] as const;
export type CollectionErrorCode=typeof collectionErrorCodes[number];
export class CollectionError extends Error {
 constructor(readonly code:CollectionErrorCode){super(code);}
}
export function collectionFailureReason(error:unknown){
 if(error instanceof CollectionError)return error.code;
 if(error instanceof Error&&(error.name==='TimeoutError'||error.name==='AbortError'))return 'SERVED_ACK_TIMEOUT';
 return 'SERVED_ACK_FAILED';
}
