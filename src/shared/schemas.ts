import { z } from "zod";

/** A web link. zod's own url() accepts schemes like javascript: that must never end up in an href. */
export const httpUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "Enter a valid http(s) link");

export const httpsUrl = httpUrl.refine((v) => v.startsWith("https://"), "Use an https link");
