using System.Text;

namespace Slopterm.Server.Ai;

/// <summary>
/// Turns raw PTY bytes into readable plain text for the model: a lenient UTF-8 decode, then
/// remove ANSI escape sequences (CSI, OSC, other ESC-prefixed) and control characters, keeping
/// only <c>\n</c>/<c>\t</c>. Deliberately lenient - malformed/partial UTF-8 at ring-buffer wrap
/// boundaries and truncated escape sequences must never throw (a throw here would surface as a
/// tool error mid-turn).
/// </summary>
public static class AnsiText
{
    public static string Strip(byte[] bytes)
    {
        // Lenient decode: invalid byte sequences become U+FFFD instead of throwing.
        var decoded = Encoding.UTF8.GetString(bytes);
        var sb = new StringBuilder(decoded.Length);

        var i = 0;
        while (i < decoded.Length)
        {
            var c = decoded[i];

            if (c == '\x1b')
            {
                i++;
                if (i >= decoded.Length)
                {
                    break; // dangling ESC at the tail - drop it
                }

                var next = decoded[i];
                if (next == '[')
                {
                    // CSI: ESC [ (parameter/intermediate bytes) final-byte(0x40-0x7E)
                    i++;
                    while (i < decoded.Length && !(decoded[i] >= '@' && decoded[i] <= '~'))
                    {
                        i++;
                    }

                    if (i < decoded.Length)
                    {
                        i++; // consume the final byte
                    }
                }
                else if (next == ']')
                {
                    // OSC: ESC ] ... terminated by BEL or ST (ESC \)
                    i++;
                    while (i < decoded.Length)
                    {
                        if (decoded[i] == '\x07')
                        {
                            i++;
                            break;
                        }

                        if (decoded[i] == '\x1b' && i + 1 < decoded.Length && decoded[i + 1] == '\\')
                        {
                            i += 2;
                            break;
                        }

                        i++;
                    }
                }
                else
                {
                    // Any other ESC-prefixed escape (charset select, etc.) - skip its one byte.
                    i++;
                }

                continue;
            }

            if (c == '\r')
            {
                // Collapse \r\n -> \n; drop a bare \r.
                if (i + 1 < decoded.Length && decoded[i + 1] == '\n')
                {
                    sb.Append('\n');
                    i += 2;
                }
                else
                {
                    i++;
                }

                continue;
            }

            if (c == '\n' || c == '\t')
            {
                sb.Append(c);
                i++;
                continue;
            }

            if (c < ' ' || c == '\x7f')
            {
                i++; // other control character - drop
                continue;
            }

            sb.Append(c);
            i++;
        }

        return sb.ToString();
    }
}
