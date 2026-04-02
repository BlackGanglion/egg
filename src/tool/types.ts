import type { Tool as PiAiTool, TextContent, ImageContent } from "@mariozechner/pi-ai";
import type { TSchema } from "@sinclair/typebox";

export interface TriageTool<TParams extends TSchema = TSchema> {
  definition: PiAiTool<TParams>;
  execute: (args: Record<string, any>) => Promise<{
    content: (TextContent | ImageContent)[];
    isError: boolean;
  }>;
}
