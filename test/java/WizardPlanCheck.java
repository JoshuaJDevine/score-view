package claude.scoreview;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * Test helper (test/wizard-test.mjs): parses a wizard plan from stdin with NewScoreWizard's own parser and prints
 * one line per plan line: "cmd key=value1|value2 ..." (values joined with " || "), plus checks of the helpers.
 */
public final class WizardPlanCheck
{
   public static void main(final String[] args) throws Exception
   {
      final String plan = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
      for (final String line : plan.split("\n"))
      {
         if (line.isBlank()) continue;
         final StringBuilder sb = new StringBuilder(line.split("\t", 2)[0]);
         for (final Map.Entry<String, List<String>> e : NewScoreWizard.fields(line).entrySet())
            sb.append(' ').append(e.getKey()).append('=').append(String.join(" || ", e.getValue()));
         System.out.println(sb);
      }
      final float[] c = NewScoreWizard.rgb("#ff8000");
      System.out.println("rgb " + c[0] + " " + c[1] + " " + c[2] + " " + (NewScoreWizard.rgb("nope") == null));
      System.out.println("newSlot " + NewScoreWizard.newSlot(List.of("A", "B"), List.of("A", "X", "B"))
         + " " + NewScoreWizard.newSlot(List.of("A", "B"), List.of("A", "B", "X"))
         + " " + NewScoreWizard.newSlot(List.of("A", "B"), List.of("A", "B")));
      final int[] m = NewScoreWizard.parseMeter("6/8");
      System.out.println("meter " + m[0] + "/" + m[1] + " " + (NewScoreWizard.parseMeter("5/6") == null) + " " + (NewScoreWizard.parseMeter("x") == null)
         + " tempo " + NewScoreWizard.parseTempo("92.5") + " " + NewScoreWizard.parseTempo("5000"));
   }
}
