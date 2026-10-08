import { randomBytes } from "node:crypto";
import { issueGraphicCaptcha, type GraphicCaptchaPurpose } from "@/lib/graphic-captcha-service";
import { normalizeMainlandPhone } from "@/lib/phone-auth-identity";

type GraphicCaptchaDb = Parameters<typeof issueGraphicCaptcha>[1];
type Actor = Readonly<{ id: string; role: string; accountAccessVersion?: number; securityRevision?: number }>;

export type GraphicCaptchaFixture = Readonly<{
  browserToken: string;
  captcha: Readonly<{ challengeId: string; answer: string }>;
}>;

/** Issues a real database-backed challenge while replacing only image rendering. */
export async function issueGraphicCaptchaFixture(input: {
  phone: unknown;
  purpose: GraphicCaptchaPurpose;
  actor?: Actor;
}, db: GraphicCaptchaDb): Promise<GraphicCaptchaFixture> {
  const browserToken = randomBytes(32).toString("base64url");
  let answer: string | undefined;
  const issued = await issueGraphicCaptcha({
    phone: normalizeMainlandPhone(input.phone),
    purpose: input.purpose,
    browserToken,
    ...(input.actor ? { actor: input.actor } : {}),
  }, db, async (generatedAnswer) => {
    answer = generatedAnswer;
    return Buffer.from("captcha-fixture-image");
  });
  if (!answer) throw new Error("GRAPHIC_CAPTCHA_FIXTURE_ANSWER_MISSING");
  if (!issued.image.startsWith("data:image/png;base64,")) throw new Error("GRAPHIC_CAPTCHA_FIXTURE_IMAGE_INVALID");
  return Object.freeze({ browserToken, captcha: Object.freeze({ challengeId: issued.challengeId, answer }) });
}
