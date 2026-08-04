import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendMediaMessage } from "./meta-api";

// Capture the JSON body each helper POSTs to Evolution so we can assert the
// exact payload shape per media kind without hitting the network.
interface CapturedBody {
  number?: string;
  mediatype?: string;
  mimetype?: string;
  media?: string;
  caption?: string;
  fileName?: string;
}
let captured: { url: string; body: CapturedBody | null } = {
  url: "",
  body: null,
};

function okFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    captured = {
      url,
      body: init?.body ? (JSON.parse(init.body as string) as CapturedBody) : null,
    };
    return {
      ok: true,
      json: async () => ({ key: { id: "wamid.TEST" } }),
    } as Response;
  });
}

const BASE = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  link: "https://cdn.example.com/file",
} as const;

describe("sendMediaMessage — payload shape", () => {
  beforeEach(() => {
    captured = { url: "", body: null };
    vi.stubGlobal("fetch", okFetch());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image with a caption and no filename", async () => {
    const result = await sendMediaMessage({
      ...BASE,
      kind: "image",
      caption: "hello",
      filename: "x.png",
    });
    expect(captured.url).toContain("message/sendMedia/test-phone");
    expect(captured.body).toEqual({
      number: "1234567890",
      mediatype: "image",
      mimetype: "image/png",
      media: BASE.link,
      caption: "hello",
    });
    expect(result).toEqual({ messageId: "wamid.TEST" });
  });

  it("sends document with both caption and filename", async () => {
    const result = await sendMediaMessage({
      ...BASE,
      kind: "document",
      caption: "invoice",
      filename: "invoice.pdf",
    });
    expect(captured.body).toEqual({
      number: "1234567890",
      mediatype: "document",
      mimetype: "application/pdf",
      media: BASE.link,
      caption: "invoice",
      fileName: "invoice.pdf",
    });
    expect(result).toEqual({ messageId: "wamid.TEST" });
  });

  it("sends audio with NO caption and NO filename (Evolution rejects both)", async () => {
    const result = await sendMediaMessage({
      ...BASE,
      kind: "audio",
      caption: "should be dropped",
      filename: "voice.ogg",
    });
    expect(captured.body).toEqual({
      number: "1234567890",
      mediatype: "audio",
      mimetype: "audio/ogg",
      media: BASE.link,
    });
    expect(result).toEqual({ messageId: "wamid.TEST" });
  });

  it("throws when no link is provided", async () => {
    await expect(
      sendMediaMessage({ ...BASE, link: "", kind: "image" }),
    ).rejects.toThrow(/requires a link/);
  });
});
