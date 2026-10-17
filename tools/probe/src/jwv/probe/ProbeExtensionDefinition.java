package jwv.probe;

import java.util.UUID;

import com.bitwig.extension.api.PlatformType;
import com.bitwig.extension.controller.AutoDetectionMidiPortNamesList;
import com.bitwig.extension.controller.ControllerExtension;
import com.bitwig.extension.controller.ControllerExtensionDefinition;
import com.bitwig.extension.controller.api.ControllerHost;

/** "Score View Probe": a throwaway extension that tests how notation could become continuous control (see ProbeExtension). */
public class ProbeExtensionDefinition extends ControllerExtensionDefinition
{
   private static final UUID ID = UUID.fromString("3f1d6b2e-8a47-4c55-b0d9-6e2a71c4f913");

   @Override public String getName() { return "Score View Probe"; }
   @Override public String getAuthor() { return "JWV"; }
   @Override public String getVersion() { return "0.1"; }
   @Override public UUID getId() { return ID; }
   @Override public String getHardwareVendor() { return "JWV"; }
   @Override public String getHardwareModel() { return "Score View Probe"; }
   @Override public int getRequiredAPIVersion() { return 24; }
   @Override public int getNumMidiInPorts() { return 0; }
   @Override public int getNumMidiOutPorts() { return 0; }

   @Override
   public void listAutoDetectionMidiPortNames(final AutoDetectionMidiPortNamesList list, final PlatformType platformType)
   {
   }

   @Override
   public ControllerExtension createInstance(final ControllerHost host)
   {
      return new ProbeExtension(this, host);
   }
}
