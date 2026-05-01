import type { ReactNode } from "react";

import { formatStatus } from "../lib/ui-format";

export function PageIntro({
  children,
}: {
  children: ReactNode;
}) {
  return <s-paragraph>{children}</s-paragraph>;
}

export function StatusBadge({
  status,
}: {
  status: string | null | undefined;
}) {
  return <s-text>[{formatStatus(status)}]</s-text>;
}

export function KpiCard({
  label,
  value,
  href,
  helpText,
}: {
  label: string;
  value: ReactNode;
  href: string;
  helpText?: ReactNode;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-heading>{value}</s-heading>
        <s-link href={href}>{label}</s-link>
        {helpText ? <s-paragraph>{helpText}</s-paragraph> : null}
      </s-stack>
    </s-box>
  );
}

export function NextActionCard({
  title,
  children,
  href,
  actionLabel,
}: {
  title: string;
  children: ReactNode;
  href: string;
  actionLabel: string;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-heading>{title}</s-heading>
        <s-paragraph>{children}</s-paragraph>
        <s-link href={href}>{actionLabel}</s-link>
      </s-stack>
    </s-box>
  );
}

export function SummaryCard({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-heading>{heading}</s-heading>
        {children}
      </s-stack>
    </s-box>
  );
}

export function WorkQueueSection({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small">
        <s-heading>{heading}</s-heading>
        {children}
      </s-stack>
    </s-box>
  );
}
