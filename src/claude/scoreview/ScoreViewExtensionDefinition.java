package claude.scoreview;

import java.util.UUID;

import com.bitwig.extension.api.PlatformType;
import com.bitwig.extension.controller.AutoDetectionMidiPortNamesList;
import com.bitwig.extension.controller.ControllerExtension;
import com.bitwig.extension.controller.ControllerExtensionDefinition;
import com.bitwig.extension.controller.api.ControllerHost;

public class ScoreViewExtensionDefinition extends ControllerExtensionDefinition
{
   private static final UUID ID = UUID.fromString("7d3c0a52-5b1e-4c1f-9f0e-2a6f3c9b8e41");

   @Override public String getName() { return "Score View"; }
   @Override public String getAuthor() { return "Claude"; }
   @Override public String getVersion() { return "0.1"; }
   @Override public UUID getId() { return ID; }
   @Override public String getHardwareVendor() { return "Claude"; }
   @Override public String getHardwareModel() { return "Score View"; }
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
      return new ScoreViewExtension(this, host);
   }
}
