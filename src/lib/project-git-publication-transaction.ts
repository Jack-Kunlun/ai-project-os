export type GitPublicationTransactionOptions = Readonly<{
  maxWait: number;
  timeout: number;
}>;

export const GIT_PUBLICATION_TRANSACTION_OPTIONS: GitPublicationTransactionOptions = Object.freeze({
  maxWait: 5_000,
  timeout: 60_000,
});
