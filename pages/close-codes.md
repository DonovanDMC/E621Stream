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
| 4008 | rate limited (over 60 messages a minute) |
| 4009 | too slow, reconnect with your last cursor |
| 4010 | too many connections (per ip or per account) |
| 4011 | your credentials stopped working |

The clients won't reconnect after 4001, 4002, 4004, 4005, 4006, 4007 or 4011, since trying again won't help.
