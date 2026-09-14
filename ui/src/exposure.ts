/**
 * Exposure vocabulary shared by the 状态 and 安全 pages.
 *
 * One map instead of two: the pages used to carry parallel copies of the same
 * concept (exposure → Chinese label / tone / note) and the wording had drifted
 * before being merged here. `label` serves the 状态 page chip, `text` the
 * 安全 page overview.
 */
export interface ExposureMeta {
  /** Short chip text on the 状态 page; a getter so it follows the language. */
  label: () => string;
  /** Longer explanation on the 安全 page overview. */
  text: () => string;
  tone: "ok" | "warn";
}

import { t } from "./i18n";

export const EXPOSURE_META: Record<string, ExposureMeta> = {
  local: {
    label: () => t("仅本机", "Local only"),
    tone: "ok",
    text: () => t("只有这台机器自己能访问，外网连不进来。", "Only this machine can reach it; nothing from outside can connect."),
  },
  "public-open": {
    label: () => t("公网可达 · 无鉴权", "Public · no auth"),
    tone: "warn",
    text: () => t(
      "公网可达且未开启鉴权：任何拿到地址的人都能直接调用。用下面的 Bearer 门禁卡一键启用（会自动先签发令牌），或先去个人令牌卡手动签发。",
      "Publicly reachable with no auth: anyone who has the address can call it. Use the Bearer gate card below to turn it on in one step (a token is issued automatically), or mint one yourself first.",
    ),
  },
  "public-authed": {
    label: () => t("公网可达 · 需令牌", "Public · token required"),
    tone: "ok",
    text: () => t("公网可达，但必须带 Bearer 令牌才能调用。", "Publicly reachable, but every call must carry a Bearer token."),
  },
};
