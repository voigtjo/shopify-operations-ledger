import type { MrpRecommendedAction } from "./material-planning.server";

export function formatQuantity(value: number) {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 4,
  }).format(value);
}

export function formatStatus(value: string | null | undefined) {
  if (!value) {
    return "Unknown";
  }

  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

export function shortReference(value: string | null | undefined) {
  if (!value) {
    return "Not linked";
  }

  return value.length > 32 ? `...${value.slice(-18)}` : value;
}

export function formatAction(action: MrpRecommendedAction) {
  return formatStatus(action);
}
