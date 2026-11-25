import { flashHTML, takeFlash, type FlashType } from "../../Flash.ts";

const ALERT_CLASSES = {
    error: "alert-danger",
    notice: "alert-info",
    success: "alert-success",
    warning: "alert-warning",
} satisfies Record<FlashType, string>;

export default function Flash(): JSX.Element {
    return (
        <>
            {takeFlash().map(({ message, type }) => {
                const safeMessage = flashHTML(message);
                return (
                    <div class={["alert", ALERT_CLASSES[type], "alert-dismissible", "fade", "show"]} role="alert">
                        <div class="flash-message">{safeMessage}</div>
                        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
                    </div>
                );
            })}
        </>
    );
}
