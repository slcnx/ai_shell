import {
  MessageOutlined,
  RobotOutlined,
  UserOutlined
} from "@ant-design/icons";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  Avatar,
  Button,
  Checkbox,
  Empty,
  List,
  Modal,
  Space,
  Spin,
  Tag,
  Typography
} from "antd";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import VirtualList from "rc-virtual-list";

const MIN_LIST_HEIGHT = 220;
const MIN_ITEM_HEIGHT = 132;
const COLLAPSE_LINE_LIMIT = 5;
const COLLAPSE_CHAR_LIMIT = 320;
const COLLAPSE_MAX_HEIGHT = 164;

export type SyncEntryPreviewItem = {
  id: string;
  kind: "input" | "output" | string;
  content: string;
  created_at_text: string;
  sid_text: string;
  included: boolean;
  preview_truncated?: boolean;
};

export type SyncEntryPreviewFullContentResult = {
  content: string;
  kind?: string;
  created_at_text?: string;
  sid_text?: string;
};

type SyncEntryPreviewListProps = {
  items: SyncEntryPreviewItem[];
  empty_text?: string;
  show_checkbox?: boolean;
  on_toggle_included?: (entryId: string, included: boolean) => void;
  user_avatar_src?: string;
  assistant_avatar_src?: string;
  auto_follow_bottom?: boolean;
  on_reach_top?: () => void;
  on_reach_bottom?: () => void;
  scroll_command?: { target: "top" | "bottom"; nonce: number } | null;
  on_request_full_content?: (
    item: SyncEntryPreviewItem
  ) => Promise<SyncEntryPreviewFullContentResult>;
};

type RoleMeta = {
  label: string;
  color: string;
  tone: "input" | "output";
  avatar: ReactNode;
  avatar_class_name: string;
  avatar_src?: string;
};

type PreviewListRow =
  | {
      type: "group";
      key: string;
      label: string;
    }
  | {
      type: "item";
      key: string;
      item: SyncEntryPreviewItem;
    };

type FullContentModalState = {
  open: boolean;
  loading: boolean;
  error: string;
  item: SyncEntryPreviewItem | null;
  result: SyncEntryPreviewFullContentResult | null;
};

function resolveRoleMeta(kind: string): RoleMeta {
  if (kind === "input") {
    return {
      label: "输入",
      color: "green",
      tone: "input",
      avatar: <UserOutlined />,
      avatar_class_name: "sync-preview-avatar-user"
    };
  }

  if (kind === "output") {
    return {
      label: "输出",
      color: "blue",
      tone: "output",
      avatar: <RobotOutlined />,
      avatar_class_name: "sync-preview-avatar-assistant"
    };
  }

  return {
    label: kind?.trim() ? kind.trim().toUpperCase() : "消息",
    color: "default",
    tone: "output",
    avatar: <MessageOutlined />,
    avatar_class_name: "sync-preview-avatar-message"
  };
}

function isExpandable(content: string): boolean {
  const normalized = content.trim();

  if (!normalized) {
    return false;
  }

  const lineCount = normalized.split(/\r\n|\r|\n/).length;
  return lineCount > COLLAPSE_LINE_LIMIT || normalized.length > COLLAPSE_CHAR_LIMIT;
}

function deriveGroupLabel(createdAtText: string): string {
  const normalized = createdAtText.trim();
  if (!normalized || normalized === "-") {
    return "更早";
  }

  const [datePart] = normalized.split(" ");
  return datePart || normalized;
}

function SyncPreviewMarkdown({
  content,
  expanded,
  className = ""
}: {
  content: string;
  expanded: boolean;
  className?: string;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState(COLLAPSE_MAX_HEIGHT);

  useEffect(() => {
    const container = contentRef.current;
    if (!container) {
      return undefined;
    }

    const syncHeight = () => {
      const nextHeight = Math.ceil(container.scrollHeight);
      if (nextHeight > 0) {
        setContentHeight(Math.max(COLLAPSE_MAX_HEIGHT, nextHeight));
      }
    };

    syncHeight();

    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const observer = new ResizeObserver(() => syncHeight());
    observer.observe(container);

    return () => observer.disconnect();
  }, [content]);

  const style: CSSProperties = {
    maxHeight: expanded ? contentHeight : COLLAPSE_MAX_HEIGHT
  };

  return (
    <div
      className={[
        "sync-preview-markdown-frame",
        expanded ? "expanded" : "collapsed",
        className
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      <div ref={contentRef} className="sync-preview-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

function SyncEntryPreviewList({
  items,
  empty_text = "暂无记录",
  show_checkbox = true,
  on_toggle_included,
  user_avatar_src,
  assistant_avatar_src,
  auto_follow_bottom = false,
  on_reach_top,
  on_reach_bottom,
  scroll_command,
  on_request_full_content
}: SyncEntryPreviewListProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const holderRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowBottomRef = useRef(true);
  const userScrollTriggeredRef = useRef(false);
  const lastReachTopHeightRef = useRef(0);
  const lastReachBottomHeightRef = useRef(0);
  const detailCacheRef = useRef<Map<string, SyncEntryPreviewFullContentResult>>(new Map());
  const [listHeight, setListHeight] = useState(MIN_LIST_HEIGHT);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [detailModal, setDetailModal] = useState<FullContentModalState>({
    open: false,
    loading: false,
    error: "",
    item: null,
    result: null
  });

  const rows = useMemo<PreviewListRow[]>(() => {
    const nextRows: PreviewListRow[] = [];
    let previousGroup = "";

    items.forEach((item, index) => {
      const groupLabel = deriveGroupLabel(item.created_at_text);

      if (groupLabel !== previousGroup) {
        nextRows.push({
          type: "group",
          key: `group-${groupLabel}-${index}`,
          label: groupLabel
        });
        previousGroup = groupLabel;
      }

      nextRows.push({
        type: "item",
        key: item.id,
        item
      });
    });

    return nextRows;
  }, [items]);

  useEffect(() => {
    setExpandedIds((current) => {
      const next = new Set<string>();

      items.forEach((item) => {
        if (current.has(item.id)) {
          next.add(item.id);
        }
      });

      return next;
    });
  }, [items]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === "undefined") {
      return undefined;
    }

    const syncHeight = () => {
      const nextHeight = Math.floor(shell.getBoundingClientRect().height);
      if (nextHeight > 0) {
        setListHeight(Math.max(MIN_LIST_HEIGHT, nextHeight));
      }
    };

    syncHeight();

    const observer = new ResizeObserver(() => syncHeight());
    observer.observe(shell);

    if (shell.parentElement) {
      observer.observe(shell.parentElement);
    }

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) {
      return undefined;
    }

    const holder = shell.querySelector<HTMLDivElement>(".rc-virtual-list-holder");
    if (!holder) {
      return undefined;
    }

    holderRef.current = holder;
    const threshold = 24;
    const syncFollowState = (allowPaging: boolean) => {
      const distanceToBottom = holder.scrollHeight - holder.scrollTop - holder.clientHeight;
      shouldFollowBottomRef.current = distanceToBottom <= threshold;
      if (allowPaging && holder.scrollTop <= threshold && on_reach_top) {
        if (holder.scrollHeight !== lastReachTopHeightRef.current) {
          lastReachTopHeightRef.current = holder.scrollHeight;
          on_reach_top();
        }
      }
      if (allowPaging && distanceToBottom <= threshold && on_reach_bottom) {
        if (holder.scrollHeight !== lastReachBottomHeightRef.current) {
          lastReachBottomHeightRef.current = holder.scrollHeight;
          on_reach_bottom();
        }
      }
    };

    syncFollowState(false);
    const handleScroll = () => {
      userScrollTriggeredRef.current = true;
      syncFollowState(true);
    };
    holder.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      holder.removeEventListener("scroll", handleScroll);
      if (holderRef.current === holder) {
        holderRef.current = null;
      }
    };
  }, [listHeight, items.length, on_reach_bottom, on_reach_top]);

  useEffect(() => {
    if (!auto_follow_bottom) {
      return;
    }

    const holder = holderRef.current;
    if (!holder || !shouldFollowBottomRef.current) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      holder.scrollTop = holder.scrollHeight;
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [auto_follow_bottom, rows.length]);

  useEffect(() => {
    userScrollTriggeredRef.current = false;
    lastReachTopHeightRef.current = 0;
    lastReachBottomHeightRef.current = 0;
  }, [items.length]);

  useEffect(() => {
    if (!scroll_command) {
      return;
    }

    const holder = holderRef.current;
    if (!holder) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      if (scroll_command.target === "top") {
        holder.scrollTop = 0;
        shouldFollowBottomRef.current = false;
      } else {
        holder.scrollTop = holder.scrollHeight;
        shouldFollowBottomRef.current = true;
      }
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [scroll_command]);

  const toggleExpanded = (entryId: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  };

  const closeDetailModal = () => {
    setDetailModal((current) => ({ ...current, open: false, loading: false }));
  };

  const openFullContentModal = async (item: SyncEntryPreviewItem) => {
    if (!on_request_full_content) {
      return;
    }

    const cached = detailCacheRef.current.get(item.id);
    if (cached) {
      setDetailModal({
        open: true,
        loading: false,
        error: "",
        item,
        result: cached
      });
      return;
    }

    setDetailModal({
      open: true,
      loading: true,
      error: "",
      item,
      result: null
    });

    try {
      const result = await on_request_full_content(item);
      detailCacheRef.current.set(item.id, result);
      setDetailModal({
        open: true,
        loading: false,
        error: "",
        item,
        result
      });
    } catch (error) {
      setDetailModal({
        open: true,
        loading: false,
        error: error instanceof Error ? error.message : "加载完整内容失败",
        item,
        result: null
      });
    }
  };

  const detailItem = detailModal.item;
  const detailResult = detailModal.result;
  const detailRole = resolveRoleMeta(detailResult?.kind || detailItem?.kind || "output");

  return (
    <>
      <div className="sync-preview-list-shell" ref={shellRef}>
        {!items.length ? (
          <div className="sync-preview-empty">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty_text} />
          </div>
        ) : (
          <List className="sync-preview-list" split={false}>
            <VirtualList<PreviewListRow>
              data={rows}
              height={listHeight}
              itemHeight={MIN_ITEM_HEIGHT}
              itemKey="key"
            >
              {(row) => {
                if (row.type === "group") {
                  return (
                    <div key={row.key} className="sync-preview-group">
                      <span>{row.label}</span>
                    </div>
                  );
                }

                const item = row.item;
                const roleBase = resolveRoleMeta(item.kind);
                const role = {
                  ...roleBase,
                  avatar_src:
                    roleBase.tone === "input"
                      ? user_avatar_src
                      : roleBase.tone === "output"
                        ? assistant_avatar_src
                        : undefined
                };
                const expandable = isExpandable(item.content);
                const expanded = expandable && expandedIds.has(item.id);

                return (
                  <List.Item
                    key={row.key}
                    className={[
                      "sync-preview-item",
                      `sync-preview-item-${role.tone}`,
                      show_checkbox && !item.included ? "excluded" : ""
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      if (!show_checkbox) {
                        return;
                      }
                      on_toggle_included?.(item.id, !item.included);
                    }}
                  >
                    <div
                      className={[
                        "sync-preview-item-role",
                        show_checkbox ? "with-tag" : "avatar-only"
                      ].join(" ")}
                    >
                      {show_checkbox ? (
                        <Checkbox
                          checked={item.included}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            on_toggle_included?.(item.id, Boolean(event.target.checked))
                          }
                        />
                      ) : null}
                      <Avatar
                        size={34}
                        icon={role.avatar}
                        src={role.avatar_src}
                        className={["sync-preview-avatar", role.avatar_class_name].join(" ")}
                      />
                      {show_checkbox ? <Tag color={role.color}>{role.label}</Tag> : null}
                    </div>

                    <div className="sync-preview-item-body">
                      <div className="sync-preview-bubble">
                        <div className="sync-preview-item-meta">
                          <Space size={[8, 4]} wrap>
                            <Typography.Text type="secondary">{item.created_at_text}</Typography.Text>
                            <Typography.Text type="secondary">SID: {item.sid_text}</Typography.Text>
                          </Space>
                        </div>

                        {item.content.trim() ? (
                          <SyncPreviewMarkdown content={item.content} expanded={!expandable || expanded} />
                        ) : (
                          <Typography.Text type="secondary">-</Typography.Text>
                        )}

                        {expandable || item.preview_truncated ? (
                          <div className="sync-preview-actions">
                            {expandable ? (
                              <Button
                                type="link"
                                size="small"
                                className="sync-preview-expand"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  toggleExpanded(item.id);
                                }}
                              >
                                {expanded ? "收起预览" : "展开预览"}
                              </Button>
                            ) : null}

                            {item.preview_truncated ? (
                              <>
                                <Tag color="warning" className="sync-preview-truncated-tag">
                                  预览已截断
                                </Tag>
                                {on_request_full_content ? (
                                  <Button
                                    type="link"
                                    size="small"
                                    className="sync-preview-detail-btn"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      void openFullContentModal(item);
                                    }}
                                  >
                                    弹窗查看完整内容
                                  </Button>
                                ) : null}
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </List.Item>
                );
              }}
            </VirtualList>
          </List>
        )}
      </div>

      <Modal
        open={detailModal.open}
        title="完整消息内容"
        onCancel={closeDetailModal}
        footer={null}
        width={960}
        destroyOnClose={false}
      >
        {detailItem ? (
          <div className="sync-preview-detail-head">
            <Space size={[8, 8]} wrap>
              <Tag color={detailRole.color}>{detailRole.label}</Tag>
              <Typography.Text type="secondary">
                {detailResult?.created_at_text || detailItem.created_at_text}
              </Typography.Text>
              <Typography.Text type="secondary">
                SID: {detailResult?.sid_text || detailItem.sid_text}
              </Typography.Text>
            </Space>
          </div>
        ) : null}

        <div className="sync-preview-detail-body">
          {detailModal.loading ? (
            <div className="sync-preview-detail-loading">
              <Spin />
            </div>
          ) : detailModal.error ? (
            <Typography.Text type="danger">{detailModal.error}</Typography.Text>
          ) : detailResult ? (
            <div className="sync-preview-detail-markdown sync-preview-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{detailResult.content}</ReactMarkdown>
            </div>
          ) : null}
        </div>
      </Modal>
    </>
  );
}

export default SyncEntryPreviewList;
