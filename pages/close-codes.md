# Close Codes

| code | meaning |
|---|---|
| 4000 | unknown error (or e621 couldn't be reached to check your credentials) |
| 4001 | unknown op |
| 4002 | invalid json or payload |
| 4003 | not identified (took too long, or sent something before identify) |
| 4004 | authentication failed |
| 4005 | already identified |
| 4006 | invalid subscription |
| 4007 | invalid cursor |
| 4008 | rate limited (over 60 messages a minute, 120 for privileged+ users) |
| 4009 | too slow, reconnect with your last cursor |
| 4010 | too many connections (per ip or per account) |
| 4011 | your credentials stopped working |
| 4012 | disconnected by an admin |
| 4013 | banned from using the service |

The clients won't reconnect after 4001, 4002, 4004, 4005, 4006, 4007, 4011, 4012 or 4013, since trying again won't help.
