// Ba's master CV as the prototype shows it (version 7, seven facts), on top of the shared
// fixture's contact block. The mock orchestrator's data/master-cv.yaml.
import type { MasterCv } from "@bs-job-agents/shared";
import { masterCvFixture } from "@bs-job-agents/shared/fixtures";

export const MASTER_CV: MasterCv = {
  ...masterCvFixture,
  version: 7,
  facts: [
    {
      id: "grad-1",
      type: "experience",
      text: "Owned a React/Node.js performance review app used by ~300 employees across VN, TH, SG, DE; embedded in internal workspace.",
      textVi: "Phụ trách ứng dụng đánh giá hiệu suất React/Node.js cho ~300 nhân viên tại VN, TH, SG, DE; tích hợp vào workspace nội bộ.",
      tags: ["react", "node", "ownership"],
      org: "Gradion",
      dates: "Sep 2025 – present",
    },
    {
      id: "grad-2",
      type: "experience",
      text: "Owned multi-country purchase order system and invoice extraction workflow for finance teams.",
      textVi: null,
      tags: ["workflow", "finance"],
      org: "Gradion",
      dates: "Sep 2025 – present",
    },
    {
      id: "grad-3",
      type: "project",
      text: "AI-assisted CV screening: n8n scoring vs requirements; Genkit flow refines prompts from reviewer votes.",
      textVi: null,
      tags: ["ai", "n8n", "genkit"],
      org: "Gradion",
      dates: "2026",
    },
    {
      id: "grad-4",
      type: "experience",
      text: "Ops: Grafana logs, Kubernetes runtime, Jenkins builds, SendGrid email.",
      textVi: null,
      tags: ["ops"],
      org: "Gradion",
      dates: null,
    },
    {
      id: "aeg-1",
      type: "experience",
      text: "Built booking, dynamic pricing and loyalty flows (AngularJS, Flutter, Firebase, Vendure).",
      textVi: null,
      tags: ["angular", "flutter"],
      org: "Aegona",
      dates: "Feb 2024 – Sep 2025",
    },
    {
      id: "apc-1",
      type: "experience",
      text: "Role-based education portal and payment flows with Next.js 14, Tailwind, Ant Design.",
      textVi: null,
      tags: ["nextjs", "payments"],
      org: "Apps Cyclone",
      dates: "Sep 2022 – Jan 2024",
    },
    {
      id: "skill-1",
      type: "skill",
      text: "JavaScript, TypeScript, React, Next.js, Vue/Nuxt, Angular, Node.js, PostgreSQL, Vitest, Playwright",
      textVi: null,
      tags: [],
      org: null,
      dates: null,
    },
  ],
};
