/** Normalize formatted clipboard input for mainland China phone fields. */
export function normalizeMainlandPhoneInput(value: string): string {
  let digits = value.replace(/\D/gu, "");
  if (digits.startsWith("0086") && digits.length === 15) digits = digits.slice(4);
  else if (digits.startsWith("86") && digits.length === 13) digits = digits.slice(2);
  return digits.slice(0, 11);
}
