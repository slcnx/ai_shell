import { EyeOutlined } from "@ant-design/icons";
import { Button, Card, Checkbox, Space, Tag, Typography } from "antd";

type SessionCandidateCardProps = {
  session_id: string;
  sid_short: string;
  selected: boolean;
  show_checkbox?: boolean;
  previewing: boolean;
  created_text: string;
  updated_text: string;
  record_count: number;
  source_files: number;
  first_input: string;
  on_toggle_selected?: (checked: boolean) => void;
  on_preview: () => void;
  on_set_current?: () => void;
  on_add_linked?: () => void;
  on_clear_current?: () => void;
  on_remove_linked?: () => void;
  set_current_disabled?: boolean;
  add_linked_disabled?: boolean;
  clear_current_disabled?: boolean;
  remove_linked_disabled?: boolean;
};

function SessionCandidateCard({
  session_id,
  sid_short,
  selected,
  show_checkbox = true,
  previewing,
  created_text,
  updated_text,
  record_count,
  source_files,
  first_input,
  on_toggle_selected,
  on_preview,
  on_set_current,
  on_add_linked,
  on_clear_current,
  on_remove_linked,
  set_current_disabled = false,
  add_linked_disabled = false,
  clear_current_disabled = false,
  remove_linked_disabled = false
}: SessionCandidateCardProps) {
  return (
    <Card
      size="small"
      hoverable
      onClick={() => on_preview()}
      className={`session-candidate-card ${selected ? "selected" : "unselected"} ${
        previewing ? "previewing" : ""
      }`}
    >
      <div className="session-candidate-head">
        <Space size={6} wrap>
          {show_checkbox ? (
            <Checkbox
              checked={selected}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => on_toggle_selected?.(Boolean(event.target.checked))}
            />
          ) : null}
          <Typography.Text code>{sid_short}</Typography.Text>
          <Typography.Text copyable={{ text: session_id }} type="secondary">
            复制 SID
          </Typography.Text>
        </Space>
        <Button
          size="small"
          type={previewing ? "primary" : "default"}
          icon={<EyeOutlined />}
          onClick={(event) => {
            event.stopPropagation();
            on_preview();
          }}
        >
          {previewing ? "预览中" : "预览"}
        </Button>
      </div>

      <Space size={6} wrap>
        <Tag>创建 {created_text}</Tag>
        <Tag>更新 {updated_text}</Tag>
        <Tag color="cyan">记录 {record_count}</Tag>
        <Tag color="blue">文件 {source_files}</Tag>
      </Space>

      <Typography.Paragraph className="session-candidate-first-input" ellipsis={{ rows: 2, tooltip: first_input }}>
        {first_input || "暂无首条输入"}
      </Typography.Paragraph>

      {on_set_current || on_add_linked || on_clear_current || on_remove_linked ? (
        <Space size={8} wrap>
          {on_set_current ? (
            <Button
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                on_set_current();
              }}
              disabled={set_current_disabled}
            >
              设为当前
            </Button>
          ) : null}
          {on_add_linked ? (
            <Button
              size="small"
              type="dashed"
              onClick={(event) => {
                event.stopPropagation();
                on_add_linked();
              }}
              disabled={add_linked_disabled}
            >
              添加关联
            </Button>
          ) : null}
          {on_clear_current ? (
            <Button
              size="small"
              danger
              onClick={(event) => {
                event.stopPropagation();
                on_clear_current();
              }}
              disabled={clear_current_disabled}
            >
              取消当前
            </Button>
          ) : null}
          {on_remove_linked ? (
            <Button
              size="small"
              danger
              type="dashed"
              onClick={(event) => {
                event.stopPropagation();
                on_remove_linked();
              }}
              disabled={remove_linked_disabled}
            >
              取消关联
            </Button>
          ) : null}
        </Space>
      ) : null}
    </Card>
  );
}

export default SessionCandidateCard;
