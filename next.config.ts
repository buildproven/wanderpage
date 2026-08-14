import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const config: NextConfig = {
  images: { unoptimized: true },
  poweredByHeader: false,
};

export default withWorkflow(config);
