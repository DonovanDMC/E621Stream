import User, { USER_ROLES, type UserRole } from "../db/models/User.ts";

export const usage = `promote <${USER_ROLES.join("|")}> <user id...>`;
export const description = "Sets e621 users' roles, the only way to make owners. Users that haven't logged in yet are created.";

/** false when the arguments were wrong */
export async function run(args: Array<string>): Promise<boolean> {
    const [role, ...rest] = args;
    const ids = rest.map(Number);
    if (!USER_ROLES.includes(role as UserRole) || ids.length === 0 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return false;

    for (const id of ids) {
        const user = await User.find(id);
        if (!user) {
            // nothing to take away
            if (role === "user") {
                console.log(`#${id} doesn't exist, skipped`);
                continue;
            }
            await User.create({ id, role: role as UserRole });
            console.log(`#${id} created as ${role}`);
        } else if (user.role === role) {
            console.log(`#${id} is already ${role}`);
        } else {
            const previous = user.role;
            await user.update({ role: role as UserRole });
            console.log(`#${id} ${previous} -> ${role}`);
        }
    }
    return true;
}
