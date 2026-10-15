import type { Request } from "express";
import { HttpError } from "./http.js";

export const requireParam = (req: Request, name: string): string => {
  const value = req.params[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `Missing path parameter: ${name}`);
  }

  return value;
};
