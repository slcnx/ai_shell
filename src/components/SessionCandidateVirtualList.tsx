import { type ReactNode, useEffect, useRef, useState } from "react";
import { Typography } from "antd";
import VirtualList from "rc-virtual-list";

const DEFAULT_LIST_HEIGHT = 240;
const MIN_LIST_HEIGHT = 1;
const DEFAULT_ITEM_HEIGHT = 172;

type SessionCandidateVirtualListProps<T extends { session_id: string }> = {
  items: T[];
  empty_text: string;
  item_height?: number;
  render_item: (item: T) => ReactNode;
};

function SessionCandidateVirtualList<T extends { session_id: string }>({
  items,
  empty_text,
  item_height = DEFAULT_ITEM_HEIGHT,
  render_item
}: SessionCandidateVirtualListProps<T>) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [listHeight, setListHeight] = useState(DEFAULT_LIST_HEIGHT);

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

  return (
    <div className="session-candidate-virtual-shell" ref={shellRef}>
      {items.length ? (
        <VirtualList<T>
          data={items}
          height={listHeight}
          itemHeight={item_height}
          itemKey="session_id"
        >
          {(item) => (
            <div key={item.session_id} className="session-candidate-virtual-item">
              {render_item(item)}
            </div>
          )}
        </VirtualList>
      ) : (
        <div className="session-candidate-virtual-empty">
          <Typography.Text type="secondary">{empty_text}</Typography.Text>
        </div>
      )}
    </div>
  );
}

export default SessionCandidateVirtualList;
