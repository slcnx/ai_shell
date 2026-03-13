import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Empty,
  Input,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Typography,
} from "antd";

type FavoriteMessageRecord = {
  id: string;
  pane_id: string;
  pane_title: string;
  provider: string;
  session_id: string;
  message_id: string;
  kind: string;
  content: string;
  created_at: number;
  favorited_at: number;
};

type FavoriteMessagesPageProps = {
  favorites: FavoriteMessageRecord[];
  loading?: boolean;
  onRefresh: () => void;
  onOpenFavorite: (favorite: FavoriteMessageRecord) => void;
  onRemoveFavorite: (favoriteId: string) => void;
  onClose: () => void;
};

function formatTs(value: number): string {
  if (!value || value <= 0) {
    return "-";
  }
  try {
    return new Date(value * 1000).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "-";
  }
}

function shortSessionId(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= 12) {
    return normalized;
  }
  return `${normalized.slice(0, 6)}...${normalized.slice(-4)}`;
}

function favoriteKindLabel(kind: string): string {
  if (kind === "input") {
    return "输入";
  }
  if (kind === "output") {
    return "输出";
  }
  return kind?.trim() || "消息";
}

export default function FavoriteMessagesPage(props: FavoriteMessagesPageProps) {
  const {
    favorites,
    loading = false,
    onRefresh,
    onOpenFavorite,
    onRemoveFavorite,
    onClose,
  } = props;
  const [keyword, setKeyword] = useState("");

  const filteredFavorites = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    if (!normalizedKeyword) {
      return favorites;
    }
    return favorites.filter((item) =>
      [
        item.provider,
        item.pane_title,
        item.session_id,
        item.kind,
        item.content,
      ]
        .join("\n")
        .toLowerCase()
        .includes(normalizedKeyword)
    );
  }, [favorites, keyword]);

  return (
    <div className="favorite-messages-page">
      <div className="favorite-messages-shell">
        <Card size="small" title="收藏消息">
          <div className="favorite-messages-toolbar">
            <Space size={[8, 8]} wrap>
              <Tag color="gold">总数 {favorites.length}</Tag>
              <Tag color="blue">筛选后 {filteredFavorites.length}</Tag>
            </Space>
            <Space size={[8, 8]} wrap>
              <Input.Search
                allowClear
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索内容 / Provider / SID"
                style={{ width: 280 }}
              />
              <Button onClick={onRefresh}>刷新</Button>
              <Button onClick={onClose}>终端工作台</Button>
            </Space>
          </div>
        </Card>

        {loading ? (
          <div className="favorite-messages-loading">
            <Spin size="large" />
          </div>
        ) : filteredFavorites.length ? (
          <div className="favorite-message-list">
            {filteredFavorites.map((item) => (
              <Card
                key={item.id}
                size="small"
                className="favorite-message-card"
                title={
                  <Space size={[8, 8]} wrap>
                    <Tag color="gold">已收藏</Tag>
                    <Tag>{item.provider || "未知 Provider"}</Tag>
                    <Tag color={item.kind === "input" ? "green" : item.kind === "output" ? "blue" : "default"}>
                      {favoriteKindLabel(item.kind)}
                    </Tag>
                    <Typography.Text strong>{item.pane_title || item.pane_id}</Typography.Text>
                  </Space>
                }
                extra={
                  <Space size={8} wrap>
                    <Button size="small" type="primary" onClick={() => onOpenFavorite(item)}>
                      跳转会话列表
                    </Button>
                    <Popconfirm
                      title="取消收藏这条消息？"
                      okText="取消收藏"
                      cancelText="保留"
                      onConfirm={() => onRemoveFavorite(item.id)}
                    >
                      <Button size="small" danger>
                        取消收藏
                      </Button>
                    </Popconfirm>
                  </Space>
                }
              >
                <div className="favorite-message-meta">
                  <Space size={[8, 8]} wrap>
                    <Typography.Text type="secondary">
                      SID: {shortSessionId(item.session_id)}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      消息时间: {formatTs(item.created_at)}
                    </Typography.Text>
                    <Typography.Text type="secondary">
                      收藏时间: {formatTs(item.favorited_at)}
                    </Typography.Text>
                  </Space>
                </div>
                <Typography.Paragraph
                  className="favorite-message-content"
                  ellipsis={{ rows: 6, expandable: true, symbol: "展开" }}
                >
                  {item.content}
                </Typography.Paragraph>
              </Card>
            ))}
          </div>
        ) : (
          <Card size="small">
            <Empty description={favorites.length ? "没有匹配的收藏消息" : "还没有收藏消息"} />
          </Card>
        )}
      </div>
    </div>
  );
}
