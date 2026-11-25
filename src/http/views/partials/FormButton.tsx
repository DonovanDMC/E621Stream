export interface FormButtonProps {
    action: string;
    buttonClass: string;
    /** Asked with confirm() before it's sent */
    confirmText?: string;
    disabled?: boolean;
    /** Sent as hidden inputs */
    fields?: Record<string, string | number>;
    text: string;
}

export default function FormButton({ action, buttonClass, confirmText, disabled, fields = {}, text }: FormButtonProps): JSX.Element {
    return (
        <form method="post" action={action} class="d-inline mb-0" data-confirm={confirmText} onsubmit={confirmText && "return confirm(this.dataset.confirm)"}>
            {Object.entries(fields).map(([name, value]) => <input type="hidden" name={name} value={String(value)} />)}
            <button type="submit" class={["btn", "btn-sm", buttonClass]} disabled={disabled}>{text}</button>
        </form>
    );
}
