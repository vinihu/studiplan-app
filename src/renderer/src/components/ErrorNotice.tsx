import { Button } from "@heroui/react";
import { Notice } from "./Notice";

/** A call that failed: what could not be done, the sentence from the library, and a way to retry. */
export function ErrorNotice({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <Notice
      status="danger"
      title={title}
      action={
        onRetry ? (
          <Button variant="outline" size="sm" onPress={onRetry}>
            Try again
          </Button>
        ) : null
      }
    >
      {message}
    </Notice>
  );
}
