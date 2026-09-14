/**
 * Exposure vocabulary shared by the 状态 and 安全 pages.
 *
 * One map instead of two: the pages used to carry parallel copies of the same
 * concept (exposure → Chinese label / tone / note) and the wording had drifted
 * before being merged here. `label` serves the 状态 page chip, `text` the
 * 安全 page overview.
 */
export interface ExposureMeta {
  /** Short chip text on the 状态 page. */
  label: string;
  /** Longer explanation on the 安全 page overview. */
  text: string;
  tone: "ok" | "warn";
}

export const EXPOSURE_META: Record<string, ExposureMeta> = {
  local: {
    label: "仅本机",
    tone: "ok",
    text: "只有这台机器自己能访问，外网连不进来。",
  },
  "public-open": {
    label: "公网可达 · 无鉴权",
    tone: "warn",
    text: "公网可达且未开启鉴权：任何拿到地址的人都能直接调用。用下面的 Bearer 门禁卡一键启用（会自动先签发令牌），或先去个人令牌卡手动签发。",
  },
  "public-authed": {
    label: "公网可达 · 需令牌",
    tone: "ok",
    text: "公网可达，但必须带 Bearer 令牌才能调用。",
  },
};
